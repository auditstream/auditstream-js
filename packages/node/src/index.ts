/** Package identifier exported by the workspace skeleton. */
export const PACKAGE_NAME: "@auditstream/node" = "@auditstream/node";

export {
  type Actor,
  type ActorType,
  type AuditAsOptions,
  type AuditContext,
  type AuditNamespace,
  type AuditScope,
  AuditstreamError,
  type AuditstreamErrorCode,
  audit,
  MAX_PAYLOAD_BYTES,
  type NestedActor,
} from "./context.js";

export {
  type ActorSource,
  type DecodedTransport,
  decodeScope,
  encodeScope,
  isTagged,
  MAX_ENCODED_COMMENT_CHARS,
  setConfigValue,
  tagSql,
} from "./transport.js";
