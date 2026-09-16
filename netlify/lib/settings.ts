import { HttpError } from './http';
export const GAME_RESET_PHRASE='yes delete';
export function requireGameResetPhrase(value:string){if(value!==GAME_RESET_PHRASE)throw new HttpError(400,`Confirmation phrase must be exactly: ${GAME_RESET_PHRASE}`);return true}
// Full Reset wipes the played night. Deliberately a different phrase from the delete
// confirmation, and in the language the Admin reads on screen, so muscle memory from one
// destructive action cannot carry the host through the other.
export const FULL_RESET_PHRASE='RESET AVOND';
export function requireFullResetPhrase(value:unknown){if(typeof value!=='string'||value!==FULL_RESET_PHRASE)throw new HttpError(400,`Confirmation phrase must be exactly: ${FULL_RESET_PHRASE}`);return true}
export function predictionCloseTime(openedAtMs:number,durationSeconds:number){return openedAtMs+durationSeconds*1000}
