import { HttpError } from './http';
export const GAME_RESET_PHRASE='yes delete';
export function requireGameResetPhrase(value:string){if(value!==GAME_RESET_PHRASE)throw new HttpError(400,`Confirmation phrase must be exactly: ${GAME_RESET_PHRASE}`);return true}
export function predictionCloseTime(openedAtMs:number,durationSeconds:number){return openedAtMs+durationSeconds*1000}
