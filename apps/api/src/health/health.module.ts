import { Module } from "@nestjs/common";

import { HealthController } from "./health.controller.js";
import { ReferenceDataCheck } from "./reference-data.check.js";

@Module({ controllers: [HealthController], providers: [ReferenceDataCheck] })
export class HealthModule {}
