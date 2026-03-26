export type { SiteTypeCheckAdapter } from "./checks.js";
export { getSiteTypeChecks, registerSiteTypeChecks } from "./checks.js";
export { ecommerceDetector } from "./ecommerce.js";
export { localBusinessDetector } from "./local-business.js";
export { detectSiteType, registerSiteTypeDetector } from "./registry.js";
export type { SiteType, SiteTypeDetectionResult, SiteTypeDetector } from "./types.js";

// Register built-in detectors
import { ecommerceDetector } from "./ecommerce.js";
import { localBusinessDetector } from "./local-business.js";
import { registerSiteTypeDetector } from "./registry.js";

registerSiteTypeDetector(ecommerceDetector);
registerSiteTypeDetector(localBusinessDetector);

// Register e-commerce checks
import { ecommerceChecks } from "../audit/checks/ecommerce.js";
import { registerSiteTypeChecks } from "./checks.js";

registerSiteTypeChecks({ siteType: "ecommerce", checks: ecommerceChecks });

// Register local business checks
import { localBusinessChecks } from "../audit/checks/local-business.js";

registerSiteTypeChecks({ siteType: "local-business", checks: localBusinessChecks });
