import type { Check } from "../types.js";
import { agentAuthChecks } from "./agent-auth.js";
import { botAccessibilityChecks } from "./bot-accessibility.js";
import { contentQualityChecks } from "./content-quality.js";
import { discoveryChecks } from "./discovery.js";
import { edgeChecks } from "./edge.js";
import { preferenceChecks } from "./preferences.js";
import { protocolChecks } from "./protocols.js";
import { reachChecks } from "./reach.js";
import { structuredDataChecks } from "./structured-data.js";
import { technicalChecks } from "./technical.js";

export const allChecks: Check[] = [
  ...botAccessibilityChecks,
  ...preferenceChecks,
  ...edgeChecks,
  ...structuredDataChecks,
  ...contentQualityChecks,
  ...discoveryChecks,
  ...protocolChecks,
  ...technicalChecks,
  ...agentAuthChecks,
  ...reachChecks,
];

export {
  agentAuthChecks,
  botAccessibilityChecks,
  structuredDataChecks,
  contentQualityChecks,
  discoveryChecks,
  edgeChecks,
  preferenceChecks,
  reachChecks,
  protocolChecks,
  technicalChecks,
};
