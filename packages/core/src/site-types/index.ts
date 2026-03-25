export { ecommerceDetector } from "./ecommerce.js";
export { detectSiteType, registerSiteTypeDetector } from "./registry.js";
export type { SiteType, SiteTypeDetectionResult, SiteTypeDetector } from "./types.js";

// Register built-in detectors
import { ecommerceDetector } from "./ecommerce.js";
import { registerSiteTypeDetector } from "./registry.js";

registerSiteTypeDetector(ecommerceDetector);
