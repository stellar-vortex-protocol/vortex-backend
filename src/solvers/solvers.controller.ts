import {
	BadRequestException,
	Body,
	Controller,
	ForbiddenException,
	Get,
	NotFoundException,
	Param,
	Patch,
	Post,
	Query,
} from "@nestjs/common";
import {
	ApiBadRequestResponse,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiQuery,
	ApiTags,
	ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { IntentsService } from "../intents/intents.service";
import { RequireScope } from "../auth/solver-credentials/require-scope.decorator";
import { ScopeGuard } from "../auth/solver-credentials/scope.guard";
import {
	buildDisputeMessage,
	buildRegisterMessage,
	buildUpdateSolverMessage,
	buildSolverStatusMessage,
	verifyStellarSignature,
} from "../common/stellar-signature";
import { SolversService, LeaderboardWindow, solverSupports } from "./solvers.service";
import { ListIntentsDto } from "../intents/dto/list-intents.dto";
import { RegisterSolverDto } from "./dto/register-solver.dto";
import { UpdateSolverDto } from "./dto/update-solver.dto";
import { UpdateSolverStatusDto } from "./dto/update-solver-status.dto";
import { PricingAggregatorService } from "../pricing/aggregator.service";

const WINDOW_SECONDS: Record<Exclude<LeaderboardWindow, "all">, number> = {
	"24h": 24 * 60 * 60,
	"7d": 7 * 24 * 60 * 60,
	"30d": 30 * 24 * 60 * 60,
};

@ApiTags("solvers")
@Controller({ path: "solvers", version: "1" })
export class SolversController {
	constructor(
		private readonly solversService: SolversService,
		private readonly intentsService: IntentsService,
		private readonly pricingAggregator: PricingAggregatorService,
	) {}

	@Post()
	async register(@Body() dto: RegisterSolverDto) {
		verifyStellarSignature(dto.address, buildRegisterMessage(dto.address), dto.proofSignature);

		return this.solversService.register({
			address: dto.address,
			name: dto.name,
			bondAmount: dto.bondAmount,
			avgFillTime: dto.avgFillTime,
			isActive: true,
			supportedChains: dto.supportedChains,
			supportedTokens: dto.supportedTokens,
		});
	}

	@Get("leaderboard")
	@ApiOperation({
		summary: "Windowed solver leaderboard",
		description:
			"Returns the ranked solver list for a specific window. This endpoint is intended for recent-performance visibility and does not alter the legacy all-time leaderboard.",
	})
	@ApiQuery({ name: "window", required: false, enum: ["24h", "7d", "30d", "all"] })
	async getLeaderboard(@Query("window") window: string = "all") {
		const resolvedWindow = this.normalizeWindow(window);
		const solvers = await this.solversService.getAll();
		const intents = await this.intentsService.getAll();
		const now = Math.floor(Date.now() / 1000);
		const cutoff = resolvedWindow === "all" ? 0 : now - WINDOW_SECONDS[resolvedWindow];

		const ranked = solvers
			.map((solver) => {
				const recentIntents = intents.filter((intent) => {
					if (intent.solver !== solver.address || intent.state !== "filled") return false;
					const timestamp = intent.filledAt ?? intent.createdAt;
					return resolvedWindow === "all" || timestamp >= cutoff;
				});
				const slashedRecent = intents.filter((intent) => {
					if (intent.solver !== solver.address || intent.state !== "slashed") return false;
					const timestamp = intent.slashedAt ?? intent.createdAt;
					return resolvedWindow === "all" || timestamp >= cutoff;
				});

				const fillsCompleted = recentIntents.length;
				const fillsFailed = slashedRecent.length;
				const total = fillsCompleted + fillsFailed;
				const successRate = total > 0 ? fillsCompleted / total : 0;
				const ageDays = Math.max(0, (now - solver.registeredAt) / 86400);
				const reputationScore = Number((successRate * Math.exp(-ageDays / 180)).toFixed(4));

				return {
					address: solver.address,
					name: solver.name,
					avatarUrl: solver.avatarUrl ?? null,
					description: solver.description ?? null,
					websiteUrl: solver.websiteUrl ?? null,
					verified: solver.verified ?? false,
					fillsCompleted,
					fillsFailed,
					successRate: Number(successRate.toFixed(4)),
					reputationScore,
					totalVolume: recentIntents
						.reduce((sum, intent) => sum + BigInt(intent.fillAmount ?? "0"), 0n)
						.toString(),
					avgFillTime: recentIntents.length
						? Math.round(
								recentIntents.reduce((sum, intent) => {
									if (!intent.filledAt) return sum;
									return sum + (intent.filledAt - intent.createdAt);
								}, 0) / recentIntents.length,
							)
						: 0,
					bondAmount: solver.bondAmount,
					isActive: solver.isActive,
					window: resolvedWindow,
				};
			})
			.filter((entry) => entry.fillsCompleted > 0 || entry.fillsFailed > 0 || resolvedWindow === "all")
			.sort((a, b) => b.reputationScore - a.reputationScore || b.fillsCompleted - a.fillsCompleted);

		return { solvers: ranked, count: ranked.length, window: resolvedWindow };
	}

	@Get()
	async getLegacyLeaderboard() {
		const solvers = (await this.solversService.getAll()).sort(
			(a, b) => b.fillsCompleted - a.fillsCompleted,
		);
		return { solvers, count: solvers.length };
	}

	@Get(":address/eligible-intents")
	async getEligibleIntents(@Param("address") address: string, @Query() dto: ListIntentsDto) {
		const solver = await this.solversService.get(address);
		if (!solver) throw new NotFoundException("Solver not found");
		if (!solver.isActive) throw new ForbiddenException("Solver is not active");

		const open = await this.intentsService.getByState("open");
		const supported = open.filter((intent) =>
			solverSupports(solver, intent.srcChain, intent.srcToken.symbol),
		);

		const minIntentSizeUsd = solver.minIntentSizeUsd;
		const eligible =
			minIntentSizeUsd === undefined || minIntentSizeUsd === null
				? supported
				: await this.filterByMinIntentSize(supported, minIntentSizeUsd);

		const limit = Math.min(dto.limit ?? 20, 100);
		const offset = dto.offset ?? 0;
		if ((dto.limit ?? 20) > 100) {
			throw new BadRequestException("Limit exceeds maximum allowed value of 100");
		}

		const page = eligible.slice(offset, offset + limit);
		return { intents: page, total: eligible.length, count: eligible.length, limit, offset };
	}

	private async filterByMinIntentSize<T extends { srcToken: { symbol: string }; amount: string }>(
		intents: T[],
		minIntentSizeUsd: number,
	): Promise<T[]> {
		const results = await Promise.all(
			intents.map(async (intent) => {
				let usdValue: number | null = null;
				try {
					usdValue = await this.pricingAggregator.getUsdValue(
						intent.srcToken.symbol,
						intent.amount,
					);
				} catch {
					usdValue = null;
				}
				// Fail open: if the intent cannot be priced, keep it visible.
				if (usdValue === null || usdValue === undefined) return intent;
				return usdValue >= minIntentSizeUsd ? intent : null;
			}),
		);
		return results.filter((intent): intent is T => intent !== null);
	}

	@Get(":address")
	async getSolver(@Param("address") address: string) {
		const solver = await this.solversService.get(address);
		if (!solver) throw new NotFoundException("Solver not found");
		return solver;
	}

	@Patch(":address")
	@RequireScope("solver:update")
	@ApiOkResponse({ description: "Updated solver record" })
	@ApiBadRequestResponse({ description: "Invalid update body" })
	@ApiUnauthorizedResponse({ description: "Missing or invalid signature" })
	@ApiNotFoundResponse({ description: "Solver not found" })
	async updateSolver(@Param("address") address: string, @Body() dto: UpdateSolverDto) {
		verifyStellarSignature(address, buildUpdateSolverMessage(address), dto.signature);
		const { signature: _signature, ...patch } = dto;
		const solver = await this.solversService.update(address, patch);
		if (!solver) throw new NotFoundException("Solver not found");
		return solver;
	}

	@Get(":address/stats")
	async getSolverStats(@Param("address") address: string, @Query("window") window?: string) {
		const solver = await this.solversService.get(address);
		if (!solver) throw new NotFoundException("Solver not found");

		const resolvedWindow = this.normalizeWindow(window ?? "all");
		const intents = await this.intentsService.getAll();
		const now = Math.floor(Date.now() / 1000);
		const cutoff = resolvedWindow === "all" ? 0 : now - WINDOW_SECONDS[resolvedWindow];
		const recentIntents = intents.filter((intent) => {
			if (intent.solver !== address) return false;
			const timestamp = intent.state === "filled" ? intent.filledAt ?? intent.createdAt : intent.slashedAt ?? intent.createdAt;
			return resolvedWindow === "all" || timestamp >= cutoff;
		});

		const completed = recentIntents.filter((intent) => intent.state === "filled");
		const fillsCompleted = completed.length;
		const fillsFailed = recentIntents.filter((intent) => intent.state === "slashed").length;
		const total = fillsCompleted + fillsFailed;
		const successRate = total > 0 ? fillsCompleted / total : 0;
		const ageDays = Math.max(0, (now - solver.registeredAt) / 86400);

		return {
			address: solver.address,
			name: solver.name,
			avatarUrl: solver.avatarUrl ?? null,
			description: solver.description ?? null,
			websiteUrl: solver.websiteUrl ?? null,
			verified: solver.verified ?? false,
			fillsCompleted,
			fillsFailed,
			successRate: Number(successRate.toFixed(4)),
			reputationScore: Number((successRate * Math.exp(-ageDays / 180)).toFixed(4)),
			totalVolume: completed
				.reduce((sum, intent) => sum + BigInt(intent.fillAmount ?? "0"), 0n)
				.toString(),
			avgFillTime: completed.length
				? Math.round(
						completed.reduce((sum, intent) => {
							if (!intent.filledAt) return sum;
							return sum + (intent.filledAt - intent.createdAt);
						}, 0) / completed.length,
					)
				: 0,
			bondAmount: solver.bondAmount,
			isActive: solver.isActive,
			window: resolvedWindow,
		};
	}

	private normalizeWindow(window: string): LeaderboardWindow {
		if (window === "24h" || window === "7d" || window === "30d" || window === "all") {
			return window;
		}
		return "all";
	}
}
