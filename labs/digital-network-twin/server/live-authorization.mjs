// The recorded owner decision a live write needs, checked again at every execution.
export const LIVE_WRITE_ADR = "docs/adr/0002-per-execution-authorization.md";

export const liveWriteAuthorized = (policy) => policy?.liveAuthorization?.adr === LIVE_WRITE_ADR && policy.liveAuthorization.acknowledgesUntested === true;
