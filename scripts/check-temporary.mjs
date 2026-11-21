import os from 'node:os';
import path from 'node:path';

if (process.platform === 'win32') {
  const normalize = (value) =>
    path.win32
      .normalize(value)
      .replace(/[\\/]+$/u, '')
      .toLowerCase();
  for (const [name, value] of Object.entries({
    TEMP: process.env.TEMP,
    tmpdir: os.tmpdir(),
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
  })) {
    if (
      (name === 'TEMP' || name === 'tmpdir' || value) &&
      (!value || !path.win32.isAbsolute(value) || normalize(value) !== String.raw`f:\temp`)
    ) {
      throw new Error(`${name} must resolve to F:/Temp; received ${value}`);
    }
  }
}
