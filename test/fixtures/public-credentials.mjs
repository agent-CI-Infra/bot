// Synthetic examples shared by the wire-level GitHub, Feishu and public board tests.
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export const exampleJwt = [part({ alg: 'RS256', typ: 'JWT' }), part({ iss: 'fixture', installation_id: 424242 }), 'test-signature_only'].join('.');
export const installationToken = 'ghs_424242_' + exampleJwt;
export const maskedInstallation = installationToken.slice(0, installationToken.lastIndexOf('_') + 1) + '****';
export const pgpBlock = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nexample material\n-----END PGP PRIVATE KEY BLOCK-----';
export const credentialExamples = [installationToken, maskedInstallation, pgpBlock].join(' | ');
export const maskedExamples = '[REDACTED] | [REDACTED] | [REDACTED]';
