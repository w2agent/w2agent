export type { SiteTypeCheckAdapter } from "./checks.js";
export { getSiteTypeChecks, registerSiteTypeChecks } from "./checks.js";
export { ecommerceDetector } from "./ecommerce.js";
export { detectSiteType, registerSiteTypeDetector } from "./registry.js";
export type { SiteType, SiteTypeDetectionResult, SiteTypeDetector } from "./types.js";

// Register built-in detectors
import { ecommerceDetector } from "./ecommerce.js";
import { registerSiteTypeDetector } from "./registry.js";

registerSiteTypeDetector(ecommerceDetector);

// Register e-commerce checks
import { ecommerceChecks } from "../audit/checks/ecommerce.js";
import { registerSiteTypeChecks } from "./checks.js";

registerSiteTypeChecks({ siteType: "ecommerce", checks: ecommerceChecks });
