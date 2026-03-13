import type { PlatformId } from "../adapters/types.js";

export type InstallActionType = "write" | "skip" | "manual" | "delete";

export interface InstallAction {
  type: InstallActionType;
  dest: string;
  content?: string;
  reason?: string;
}

export interface InstallPlan {
  platform: PlatformId;
  actions: InstallAction[];
  warnings: string[];
  postInstallSteps: string[];
}
