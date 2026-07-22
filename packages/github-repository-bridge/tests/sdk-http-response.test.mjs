import assert from "node:assert/strict";
import { test } from "node:test";

import { reconstructHttpResponse } from "../../../.paperclip-sdk/plugin-sdk/src/worker-rpc-host.ts";

test("vendored plugin SDK reconstructs a bodyless 204 response", async () => {
  const response = reconstructHttpResponse({
    status: 204,
    statusText: "No Content",
    headers: {},
    body: "",
  });

  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});
