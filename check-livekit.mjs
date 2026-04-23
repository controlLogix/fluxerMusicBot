// Check LiveKit rtc-node exports
const rtc = await import('@livekit/rtc-node');
console.log('Available exports:', Object.keys(rtc).sort().join(', '));
console.log('Room methods:', Object.getOwnPropertyNames(rtc.Room.prototype).join(', '));
console.log('AudioSource methods:', Object.getOwnPropertyNames(rtc.AudioSource.prototype).join(', '));
if (rtc.AudioFrame) {
  console.log('AudioFrame:', typeof rtc.AudioFrame);
}
if (rtc.LocalAudioTrack) {
  console.log('LocalAudioTrack methods:', Object.getOwnPropertyNames(rtc.LocalAudioTrack.prototype).join(', '));
}
if (rtc.TrackPublishOptions) {
  console.log('TrackPublishOptions:', rtc.TrackPublishOptions);
}
console.log('\nTrackSource enum:', rtc.TrackSource || 'not found');