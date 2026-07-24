import { prisma } from '../../config/db';

export class CategoryService {
  async categorizeActivity(appName?: string | null, domain?: string | null): Promise<'productive' | 'neutral' | 'unproductive'> {
    if (!appName && !domain) return 'neutral';

    const categories = await prisma.category.findMany();

    for (const cat of categories) {
      const pattern = cat.pattern.toLowerCase();
      if (appName && appName.toLowerCase().includes(pattern)) {
        return cat.category as any;
      }
      if (domain && domain.toLowerCase().includes(pattern)) {
        return cat.category as any;
      }
    }

    return 'neutral';
  }
}

export const categoryService = new CategoryService();
