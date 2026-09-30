import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { DatasetsService } from "./datasets.service";

@ApiTags("datasets")
@Controller("api/v1/datasets")
export class DatasetsController {
  constructor(private readonly datasetsService: DatasetsService) {}

  @Get()
  @ApiOperation({ summary: "List published dataset dates, revisions, and schemas" })
  list() {
    return this.datasetsService.listDatasets();
  }

  @Get("schemas")
  @ApiOperation({ summary: "List the versioned schemas for every dataset kind" })
  schemas() {
    return this.datasetsService.listSchemas();
  }
}
