import { Controller, Get, NotFoundException } from "@nestjs/common";
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { DatasetPublication, DatasetsService } from "./datasets.service";

@ApiTags("datasets")
@Controller({ path: "datasets", version: "1" })
export class DatasetsController {
  constructor(private readonly datasetsService: DatasetsService) {}

  @Get()
  @ApiOperation({ summary: "List published dataset dates, revisions, and schemas" })
  list() {
    return this.datasetsService.listDatasets();
  }

  @Get("latest")
  @ApiOperation({ summary: "Get the most recent dataset publication (newest date, highest revision)" })
  @ApiOkResponse({ description: "The latest publication, in the same shape as one entry of GET /datasets" })
  @ApiNotFoundResponse({ description: "Nothing has been published yet" })
  async latest(): Promise<DatasetPublication> {
    const latest = await this.datasetsService.getLatest();
    if (!latest) throw new NotFoundException("No datasets have been published yet");
    return latest;
  }

  @Get("schemas")
  @ApiOperation({ summary: "List the versioned schemas for every dataset kind" })
  schemas() {
    return this.datasetsService.listSchemas();
  }
}
