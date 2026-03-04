import type { Check } from "../types.js";
import { botAccessibilityChecks } from "./bot-accessibility.js";
import { structuredDataChecks } from "./structured-data.js";
import { contentQualityChecks } from "./content-quality.js";
import { discoveryChecks } from "./discovery.js";
import { protocolChecks } from "./protocols.js";
import { technicalChecks } from "./technical.js";

export const allChecks: Check[] = [
  ...botAccessibilityChecks,
  ...structuredDataChecks,
  ...contentQualityChecks,
  ...discoveryChecks,
  ...protocolChecks,
  ...technicalChecks,
];

export {
  botAccessibilityChecks,
  structuredDataChecks,
  contentQualityChecks,
  discoveryChecks,
  protocolChecks,
  technicalChecks,
};
