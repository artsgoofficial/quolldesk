import test from "node:test";
import assert from "node:assert/strict";

import {
  createQuollAnthropicSignatureRetryError,
  createQuollRequestTooLargeRetryError,
  hadToolProgressBeforeRequestTooLarge,
} from "./quollRequestTooLargeRetry.ts";
import { isInvalidAnthropicThinkingSignatureError } from "./errorClassifier.ts";

test("createQuollRequestTooLargeRetryError marks 413 retry errors after tool progress", () => {
  const source = Object.assign(new Error("HTTP 413 Request Entity Too Large"), {
    status: 413,
    responseBody: "<html>too large</html>",
  });

  const retryError = createQuollRequestTooLargeRetryError(source, true);

  assert.equal(retryError.statusCode, 413);
  assert.equal(retryError.status, 413);
  assert.equal(retryError.responseBody, "<html>too large</html>");
  assert.equal(retryError.cause, source);
  assert.equal(hadToolProgressBeforeRequestTooLarge(retryError), true);
});

test("hadToolProgressBeforeRequestTooLarge is false when no tool progress was recorded", () => {
  const retryError = createQuollRequestTooLargeRetryError("HTTP 413", false);

  assert.equal(hadToolProgressBeforeRequestTooLarge(retryError), false);
  assert.equal(hadToolProgressBeforeRequestTooLarge(new Error("HTTP 413")), false);
});

test("createQuollAnthropicSignatureRetryError preserves classifier fields and tool progress", () => {
  const source = Object.assign(
    new Error("Invalid signature in thinking block. The block is bound to a different conversation."),
    {
      statusCode: 400,
      responseBody: JSON.stringify({
        error: {
          message: "Invalid signature in thinking block. The block is bound to a different conversation.",
        },
      }),
    },
  );

  const retryError = createQuollAnthropicSignatureRetryError(source, true);

  assert.equal(retryError.statusCode, 400);
  assert.equal(retryError.responseBody, source.responseBody);
  assert.equal(retryError.cause, source);
  assert.equal(hadToolProgressBeforeRequestTooLarge(retryError), true);
  assert.equal(isInvalidAnthropicThinkingSignatureError(retryError), true);
});

test("createQuollAnthropicSignatureRetryError defaults status 400 and no progress", () => {
  const retryError = createQuollAnthropicSignatureRetryError(
    "Invalid signature in thinking block. The block is bound to a different conversation.",
    false,
  );

  assert.equal(retryError.statusCode, 400);
  assert.equal(hadToolProgressBeforeRequestTooLarge(retryError), false);
  assert.equal(isInvalidAnthropicThinkingSignatureError(retryError), true);
});

test("createQuollAnthropicSignatureRetryError preserves plain-object SSE signature message", () => {
  const source = {
    type: "invalid_request_error",
    message: "Invalid signature in thinking block",
    status: 400,
  };

  const retryError = createQuollAnthropicSignatureRetryError(source, false);

  assert.equal(retryError.message, "Invalid signature in thinking block");
  assert.notEqual(retryError.message, "[object Object]");
  assert.equal(retryError.statusCode, 400);
  assert.equal(retryError.status, 400);
  assert.equal(retryError.cause, source);
  assert.equal(isInvalidAnthropicThinkingSignatureError(retryError), true);
});

test("createQuollAnthropicSignatureRetryError preserves plain-object message with statusCode", () => {
  const source = {
    type: "invalid_request_error",
    message: "Invalid signature in thinking block. The block is bound to a different conversation.",
    statusCode: 400,
  };

  const retryError = createQuollAnthropicSignatureRetryError(source, true);

  assert.equal(
    retryError.message,
    "Invalid signature in thinking block. The block is bound to a different conversation.",
  );
  assert.equal(retryError.statusCode, 400);
  assert.equal(hadToolProgressBeforeRequestTooLarge(retryError), true);
  assert.equal(isInvalidAnthropicThinkingSignatureError(retryError), true);
});
