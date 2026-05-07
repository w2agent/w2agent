import type { Check } from "../types.js";
import { agentAuthChecks } from "./agent-auth.js";
import { botAccessibilityChecks } from "./bot-accessibility.js";
import { contentQualityChecks } from "./content-quality.js";
import { discoveryChecks } from "./discovery.js";
import { multiUaSimChecks } from "./multi-ua-sim.js";
import { protocolChecks } from "./protocols.js";
import { structuredDataChecks } from "./structured-data.js";
import { technicalChecks } from "./technical.js";

export const allChecks: Check[] = [
  ...botAccessibilityChecks,
  ...structuredDataChecks,
  ...contentQualityChecks,
  ...discoveryChecks,
  ...protocolChecks,
  ...technicalChecks,
  ...agentAuthChecks,
  ...multiUaSimChecks,
];

export {
  agentAuthChecks,
  botAccessibilityChecks,
  structuredDataChecks,
  contentQualityChecks,
  discoveryChecks,
  multiUaSimChecks,
  protocolChecks,
  technicalChecks,
};
