// Refusals made before anything was sent. Any other refusal on a write may have happened after the vendor acted.
export const PRE_SEND_REFUSALS = new Set(["method_not_allowed", "url_invalid", "not_https", "userinfo_not_permitted", "host_blocked", "host_not_allowlisted"]);
