/**
 * Credential-shaped content is distinct from trace-only field filtering and JSON formatting. The rules live with the
 * runner, which applies them inside the project computer, so both sides recognize the same formats (#1087).
 */
export { credentialShapeStream, githubTokenSource, githubTokens, hasCredentials, redactCredentials, redactCredentialShapes } from '../../runner/credential-redaction.mjs';
