// node:fs and node:fs/promises for the engine. The bot's file-based stores (the CLI's) are not
// used on the phone; only travian.js's mkdir before a screenshot is, and the app creates the
// screenshot's folder itself.
const unavailable = (name) => () => {
  throw new Error(`fs.${name} is not available in the Android engine`);
};

export const mkdir = async () => {};
export const readFile = async () => unavailable('readFile')();
export const writeFile = async () => unavailable('writeFile')();
export const readdir = async () => [];
export const rm = async () => {};
export const stat = async () => unavailable('stat')();
export const open = async () => unavailable('open')();
export const rmSync = () => {};
export const readFileSync = unavailable('readFileSync');

const fs = {
  mkdir, readFile, writeFile, readdir, rm, stat, open, rmSync, readFileSync,
};
export const promises = fs;
export default fs;
