// A collector may only read. This wraps a guarded HTTP client so that any method other than GET is refused before it
// reaches the network, whatever an adapter asks for.
import { HttpRefusal } from "../live/guarded-http.mjs";

export function readOnly(http) {
  return (request) => {
    if (request?.method !== "GET") throw new HttpRefusal("collector_is_read_only");
    return http(request);
  };
}
