import type { ContentTypeHandler, SourceFiles } from '../types.js';
import { mediaHandler } from './media.js';

/** Body key holding the vCard text next to the uploaded file. */
const VCF_DATA = 'vcfData';

const media = mediaHandler('vcf', 'sfdc_cms__vcf');

/**
 * The single binary companion (the vCard file) as UTF-8 text, if there is one.
 * @param {SourceFiles} files - Source files of one component.
 * @returns {string | undefined} File text.
 */
function fileText(files: SourceFiles): string | undefined {
  const binaries = Object.values(files.companions);
  if (binaries.length !== 1) return undefined;
  const [content] = binaries;
  return typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
}

/**
 * Contact Card (`sfdc_cms__vcf`): a media type, the uploaded vCard next to the JSON. Salesforce
 * requires `vcfData` (the vCard text) on create and stores it independently of the file, so the
 * JSON leaves it out while it equals the file, and deploy fills it from the file when absent.
 * A `vcfData` that differs from the file stays in the JSON and is sent as it is.
 */
export const vcfHandler: ContentTypeHandler = {
  ...media,
  toSource(native, context): SourceFiles {
    const files = media.toSource(native, context);
    const body = files.document.contentBody;
    if (body[VCF_DATA] !== undefined && body[VCF_DATA] === fileText(files)) {
      files.document.contentBody = Object.fromEntries(
        Object.entries(body).filter(([key]) => key !== VCF_DATA),
      );
    }
    return files;
  },
  fromSource(files, context) {
    const payload = media.fromSource(files, context);
    if (payload.file && payload.contentBody[VCF_DATA] === undefined)
      payload.contentBody = {
        ...payload.contentBody,
        [VCF_DATA]: Buffer.from(payload.file.bytes).toString('utf8'),
      };
    return payload;
  },
};
