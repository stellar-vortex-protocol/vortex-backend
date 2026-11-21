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
	UseGuards,
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
import { AdminGuard } from "../admin/admin.guard";
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

const WINDOW_SECONDS: Record<Exclude<LeaderboardWindow, "all">, number> = {
	"24h": 24 * 60 * 60,
	"7d": 7 * 24 * 60 * 60,
	"30d": 30 * 24 * 60 * 60,
};

const COHORT_AGE_MARKS = [7, 30, 90] as const;
const DEFAULT_RECENCY_WINDOW_DAYS = 30;
const SECONDS_PER_DAY = 24 * 60 * 60;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;

@ApiTags("solvers")
@Controller({ path: "solvers", version: "1" })
export class SolversController {
	constructor(
		private readonly solversService: SolversService,
		private readonly intentsService: IntentsService,
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

	@Get("cohort-retention")
	@UseGuards(AdminGuard)
	@ApiOperation({
		summary: "Solver cohort retention report",
		description:
			"Buckets solvers into weekly cohorts by registration time and reports the fraction still active at 7/30/90-day marks. Admin-only operator metric.",
	})
	@ApiQuery({
		name: "recencyWindowDays",
		required: false,
		type: Number,
		description: "Days since lastActiveAt to still count as active (default 30).",
	})
	@ApiOkResponse({ description: "Weekly cohort retention report" })
	@ApiUnauthorizedResponse({ description: "Admin credentials required" })
	async getCohortRetention(@Query("recencyWindowDays") recencyWindowDays?: string) {
		const recencyDays = this.parseRecencyWindow(recencyWindowDays);
		const solvers = await this.solversService.getAll();
		const now = Math.floor(Date.now() / 1000);
		const recencyCutoff = now - recencyDays * SECONDS_PER_DAY;

		const cohorts = new Map<number, typeof solvers>();
		for (const solver of solvers) {
			const weekStart = Math.floor(solver.registeredAt / SECONDS_PER_WEEK) * SECONDS_PER_WEEK;
			const bucket = cohorts.get(weekStart);
			if (bucket) bucket.push(solver);
			else cohorts.set(weekStart, [solver]);
		}

		const report = Array.from(cohorts.entries())
			.sort((a, b) => a[0] - b[0])
			.map(([weekStart, members]) => {
				const retention: Record<string, number | null> = {};
				for (const mark of COHORT_AGE_MARKS) {
					const markCutoff = weekStart + mark * SECONDS_PER_DAY;
					if (now < markCutoff) {
						retention[`day${mark}`] = null;
						continue;
					}
					const active = members.filter((solver) => {
						if (solver.isActive) return true;
						return solver.lastActiveAt != null && solver.lastActiveAt >= recencyCutoff;
					}).length;
					retention[`day${mark}`] = members.length > 0 ? Number((active / members.length).toFixed(4)) : null;
				}

				return {
					cohortWeekStart: weekStart,
					cohortWeekStartIso: new Date(weekStart * 1000).toISOString(),
					cohortSize: members.length,
					retention,
				};
			});

		return {
			cohorts: report,
			count: report.length,
			recencyWindowDays: recencyDays,
			ageMarks: [...COHORT_AGE_MARKS],
		};
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
		const eligible = open.filter((intent) => solverSupports(solver, intent.srcChain, intent.srcToken.symbol));
		const limit = Math.min(dto.limit ?? 20, 100);
		const offset = dto.offset ?? 0;
		if ((dto.limit ?? 20) > 100) {
			throw new BadRequestException("Limit exceeds maximum allowed value of 100");
		}

		const page = eligible.slice(offset, offset + limit);
		return { intents: page, total: eligible.length, count: eligible.length, limit, offset };
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
			fillsCompleted,
			fillsFailed,
			successRate: Number(successRate.toFixed(4)),
			reputationScore: Number((successRate * Math.exp(-ageDays / 180)).toFixed(4)),
			totalVolume: completed.reduce((sum, intent) => sum + BigInt(intent.fillAmount ?? "0"), 0n).toString(),
			avgFillTime: completed.filter((intent) => intent.filledAt != null).length
				? Math.round(
						completed.reduce((sum, intent) => sum + ((intent.filledAt ?? intent.createdAt) - intent.createdAt), 0) /
							completed.filter((intent) => intent.filledAt != null).length,
					)
				: 0,
			window: resolvedWindow,
		};
	}

	private parseRecencyWindow(value?: string): number {
		if (value == null || value === "") return DEFAULT_RECENCY_WINDOW_DAYS;
		const parsed = Number(value);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			throw new BadRequestException("recencyWindowDays must be a positive number");
		}
		return parsed;
	}

	private normalizeWindow(window: string): LeaderboardWindow {
		if (window === "24h" || window === "7d" || window === "30d" || window === "all") {
			return window;
		}
		throw new BadRequestException("Invalid window. Expected one of: 24h, 7d, 30d, all");
	}
}
