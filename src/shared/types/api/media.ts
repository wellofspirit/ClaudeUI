import type { MediaCatalog } from '../../media-generation'

/** The media generation catalog (`config`, a query both transports serve). */
export interface MediaAPI {
  /** The image and video models of the sources connected now, and which sources those are. */
  listMediaModels(): Promise<MediaCatalog>
}
