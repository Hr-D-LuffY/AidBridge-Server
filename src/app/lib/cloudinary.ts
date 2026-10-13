import { v2 as cloudinary } from 'cloudinary'
import httpStatus from 'http-status'
import { config } from '../config'
import { MediaType } from '../constants/sos'
import { AppError } from '../errorHelpers/AppError'

export interface StoredMedia {
  url: string
  publicId: string
  resourceType: MediaType
}

type DeletableMedia = Pick<StoredMedia, 'publicId' | 'resourceType'>

let configured = false

// CLOUDINARY_URL is cloudinary://<api_key>:<api_secret>@<cloud_name>. The SDK could read it from
// process.env itself, but application code only reads the validated config, so it is parsed from
// there on first use. Throws 503 when the server has no Cloudinary account configured.
export const assertMediaStorageConfigured = () => {
  if (configured) return
  if (!config.cloudinaryUrl) {
    throw new AppError(httpStatus.SERVICE_UNAVAILABLE, 'Media uploads are not configured')
  }
  const { username, password, hostname } = new URL(config.cloudinaryUrl)
  cloudinary.config({
    cloud_name: hostname,
    api_key: username,
    api_secret: password,
    secure: true,
  })
  configured = true
}

// `allowedFormats` makes Cloudinary check the file's real content, not only the MIME type the
// client claimed.
export const uploadMediaBuffer = (buffer: Buffer, folder: string, allowedFormats: string[]) =>
  new Promise<StoredMedia>((resolve, reject) => {
    assertMediaStorageConfigured()
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'auto', allowed_formats: allowedFormats },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error('Cloudinary upload failed'))
          return
        }
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          resourceType: result.resource_type === 'video' ? MediaType.VIDEO : MediaType.IMAGE,
        })
      },
    )
    stream.end(buffer)
  })

// Best-effort: a failed cleanup must never fail the request that triggered it. The orphaned file
// is logged so it can be removed by hand.
export const deleteMedia = async ({ publicId, resourceType }: DeletableMedia) => {
  try {
    assertMediaStorageConfigured()
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType })
  } catch (error) {
    console.error(`Cloudinary delete(${publicId}) failed, the file stays orphaned:`, error)
  }
}
