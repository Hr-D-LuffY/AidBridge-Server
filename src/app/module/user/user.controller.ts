import httpStatus from 'http-status'
import { Role } from '../../constants/role'
import { catchAsync } from '../../utils/catchAsync'
import { getAuthUser } from '../../utils/getAuthUser'
import { sendResponse } from '../../utils/sendResponse'
import { idParamSchema } from '../../utils/validation'
import { blockUserSchema, createAccountSchema, listUsersQuerySchema } from './user.interface'
import { UserService } from './user.service'

const listUsers = catchAsync(async (req, res) => {
  const query = listUsersQuerySchema.parse(req.query)
  const { items, meta } = await UserService.listUsers(getAuthUser(req), query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Users retrieved successfully',
    data: items,
    meta,
  })
})

const getUserById = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const user = await UserService.getUserById(getAuthUser(req), id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'User retrieved successfully',
    data: user,
  })
})

const createAccount = catchAsync(async (req, res) => {
  const payload = createAccountSchema.parse(req.body)
  const user = await UserService.createAccount(getAuthUser(req), payload)

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: `${payload.role === Role.ADMIN ? 'Admin' : 'NGO'} account created successfully`,
    data: user,
  })
})

const blockUser = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = blockUserSchema.parse(req.body ?? {})
  const user = await UserService.blockUser(getAuthUser(req), id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Account blocked successfully',
    data: user,
  })
})

const unblockUser = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const user = await UserService.unblockUser(getAuthUser(req), id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Account unblocked successfully',
    data: user,
  })
})

export const UserController = { listUsers, getUserById, createAccount, blockUser, unblockUser }
