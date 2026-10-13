import httpStatus from 'http-status'
import multer from 'multer'
import { MAX_SOS_MEDIA_FILE_BYTES, SOS_MEDIA_FORMATS } from '../constants/sos'
import { AppError } from '../errorHelpers/AppError'

// Memory storage: the buffer goes straight to Cloudinary and nothing touches this server's disk
// (the filesystem on Render is ephemeral). Original filenames are never used.
export const uploadSosMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SOS_MEDIA_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    // MulterError's message is a fixed lookup by code, so a rejected type is an AppError instead.
    if (!Object.hasOwn(SOS_MEDIA_FORMATS, file.mimetype)) {
      cb(
        new AppError(
          httpStatus.BAD_REQUEST,
          'Only JPG, PNG, GIF, MP4, MOV or AVI files are allowed',
        ),
      )
      return
    }
    cb(null, true)
  },
})
