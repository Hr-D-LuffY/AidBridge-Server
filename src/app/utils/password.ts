import bcrypt from 'bcryptjs'
import { config } from '../config'

export const hashPassword = (password: string) => bcrypt.hash(password, config.bcryptSaltRounds)

export const comparePassword = (password: string, hashedPassword: string) =>
  bcrypt.compare(password, hashedPassword)
