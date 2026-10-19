// Windows device names, which no file or folder may take: the one rule for the studio's server, the
// path rules its brains work under and the office's pack checks. Pure, so the office loads it in the
// browser as well as the server in Node.

/**
 * A Windows device name (CON, PRN, AUX, NUL, CLOCK$, CONIN$, CONOUT$, COM0-9, LPT0-9 and their
 * superscript-digit forms), in any case, with or without an extension: Windows opens the device for
 * it in any folder, where Node reads it as a file.
 */
export const DEVICE_NAME = /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])\s*(\..*)?$/i;

/** Whether one name of a path is a Windows device name. */
export function isDeviceName(name: string): boolean {
  return DEVICE_NAME.test(name);
}
