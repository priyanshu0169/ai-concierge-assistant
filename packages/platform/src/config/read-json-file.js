import { readFile } from 'node:fs/promises';
import { ConfigurationError } from '../errors/errors.js';

/**
 * Read and parse a JSON file, converting both failure modes into a single
 * actionable configuration error.
 *
 * @param {string} filePath Absolute path.
 * @returns {Promise<unknown>} The parsed document, unvalidated.
 * @throws {ConfigurationError} If the file is unreadable or not valid JSON.
 */
export async function readJsonFile(filePath) {
  const contents = await readFileOrFail(filePath);

  try {
    return JSON.parse(contents);
  } catch (cause) {
    throw new ConfigurationError(`Configuration file is not valid JSON: ${filePath}`, {
      cause,
      details: { filePath },
    });
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readFileOrFail(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (cause) {
    throw new ConfigurationError(`Unable to read configuration file: ${filePath}`, {
      cause,
      details: { filePath },
    });
  }
}
