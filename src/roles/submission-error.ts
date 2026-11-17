import {TaskError} from '../agent/common.js';
/** Facts collected at the rejecting boundary, safe for the caller that made the submission. */
export class SubmissionError extends TaskError {
 constructor(code:string,readonly clues:Record<string,unknown>){super(code,'retry_wait',JSON.stringify(clues));}
}
