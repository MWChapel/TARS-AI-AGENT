import { config } from '../config';
import { Speaker, SpeakerLike } from './speaker';
import { QwenSpeaker } from './qwenSpeaker';

export function createSpeaker(): SpeakerLike {
  return config.qwenTts.enabled ? new QwenSpeaker() : new Speaker();
}
