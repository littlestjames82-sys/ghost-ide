import './domstub.mjs';
process.on('unhandledRejection', () => {});
const target = process.argv[2];
try {
  await import(target);
  console.log('RESULT: evaluated fully (no synchronous throw)');
} catch (e) {
  console.log('RESULT: ' + e.constructor.name + ': ' + String(e.message).slice(0, 140));
}
