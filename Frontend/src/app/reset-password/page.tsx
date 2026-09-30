import { redirect } from 'next/navigation';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  if (params.token) query.set('token', params.token);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  redirect(`/forgot-password${suffix}`);
}
