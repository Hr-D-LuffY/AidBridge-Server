import httpStatus from 'http-status'
import { catchAsync } from '../../utils/catchAsync'
import { getAuthUser } from '../../utils/getAuthUser'
import { sendResponse } from '../../utils/sendResponse'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordParamsSchema,
  resetPasswordSchema,
  updateMeSchema,
} from './auth.interface'
import { AuthService } from './auth.service'

const register = catchAsync(async (req, res) => {
  const payload = registerSchema.parse(req.body)
  const result = await AuthService.register(payload)

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'Account created successfully',
    data: result,
  })
})

const login = catchAsync(async (req, res) => {
  const payload = loginSchema.parse(req.body)
  const result = await AuthService.login(payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Logged in successfully',
    data: result,
  })
})

const forgotPassword = catchAsync(async (req, res) => {
  const { email } = forgotPasswordSchema.parse(req.body)
  await AuthService.forgotPassword(email)

  // Same answer whether or not the email is registered.
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'If an account with that email exists, a password reset link has been sent',
    data: {},
  })
})

const resetPassword = catchAsync(async (req, res) => {
  const { token } = resetPasswordParamsSchema.parse(req.params)
  const payload = resetPasswordSchema.parse(req.body)
  await AuthService.resetPassword(token, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Password reset successfully. Please log in with your new password',
    data: {},
  })
})

const changePassword = catchAsync(async (req, res) => {
  const payload = changePasswordSchema.parse(req.body)
  const result = await AuthService.changePassword(getAuthUser(req).id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Password changed successfully',
    data: result,
  })
})

const getMe = catchAsync(async (req, res) => {
  const user = await AuthService.getMe(getAuthUser(req).id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Profile retrieved successfully',
    data: user,
  })
})

const updateMe = catchAsync(async (req, res) => {
  const payload = updateMeSchema.parse(req.body)
  const user = await AuthService.updateMe(getAuthUser(req).id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Profile updated successfully',
    data: user,
  })
})

const deleteMe = catchAsync(async (req, res) => {
  await AuthService.deleteMe(getAuthUser(req).id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Account deleted successfully',
    data: {},
  })
})

export const AuthController = {
  register,
  login,
  forgotPassword,
  resetPassword,
  changePassword,
  getMe,
  updateMe,
  deleteMe,
}
