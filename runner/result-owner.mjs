import { createHash } from 'node:crypto';

// Shared by the control plane and manager: a result directory belongs to a computer, never a model-supplied path.
export const computerResultOwner = (kind, id) => kind + '-' + createHash('sha256').update(String(id)).digest('hex');
