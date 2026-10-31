// The homepage photograph rule lives in shared/sky.js (homeViewFor) since 20 Oct evening: a module of its own was a
// new request on every visit (smoke zoom.net). Nothing on the site loads this file; it re-exports the rule for the
// offline tests (renders/phone-frame/tools/unchanged_views.mjs).
export { homeViewFor, HOME_PORTRAIT_BELOW as PORTRAIT_BELOW, PHONE_MAX_W } from "./sky.js";
