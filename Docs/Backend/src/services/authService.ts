import { auth } from '../config/auth';
import { prisma } from '../config/db';
import { RegisterDto, LoginDto } from '../dtos/auth.dto';

export class AuthService {
  /**
   * Register a new user using Better Auth API.
   * Standard registration for dashboard managers / admins.
   */
  async registerUser(dto: RegisterDto) {
    // Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw { statusCode: 400, message: 'User with this email already exists' };
    }

    // Call Better Auth sign up API
    const response = await auth.api.signUpEmail({
      body: {
        email: dto.email,
        password: dto.password,
        name: dto.name,
        role: dto.role || 'manager',
      },
    });

    return response;
  }

  /**
   * Login user via Better Auth API
   */
  async loginUser(dto: LoginDto) {
    const response = await auth.api.signInEmail({
      body: {
        email: dto.email,
        password: dto.password,
      },
    });

    if (!response) {
      throw { statusCode: 401, message: 'Invalid email or password' };
    }

    return response;
  }

  /**
   * Get current user profile by ID
   */
  async getUserProfile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }

    return user;
  }
}

export const authService = new AuthService();
