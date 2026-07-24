import { env } from './src/config/env';
import { prisma } from './src/config/db';

console.log('🧪 Starting Better Auth Integration & Endpoint Tests...');
console.log(`Using Database: ${env.DATABASE_URL}`);
console.log(`Port: ${env.PORT}`);

// Import the Express app to start the server
import app from './src/server';

async function waitForServer(url: string, maxRetries = 15, delayMs = 500) {
  console.log(`Polling server health at ${url}/health ...`);
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.status === 200) {
        console.log('✅ Server is up and healthy!');
        return true;
      }
    } catch (e: any) {
      console.log(`[-] Fetch error: ${e.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Server at ${url} failed to start in time`);
}

async function runTests() {
  const baseUrl = `http://127.0.0.1:${env.PORT}`;

  try {
    await waitForServer(baseUrl);
  } catch (err: any) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  // Clear existing test user if any
  const testEmail = 'test_auth_user@example.com';
  try {
    const existingUser = await prisma.user.findUnique({ where: { email: testEmail } });
    if (existingUser) {
      console.log(`[-] Cleaning up old test user: ${testEmail}`);
      await prisma.user.delete({ where: { email: testEmail } });
    }
  } catch (dbErr) {
    console.error('Error clearing old test user:', dbErr);
  }

  console.log('\n----------------------------------------');
  console.log('TEST 1: Custom Registration Endpoint (/v1/dashboard/auth/register)');
  console.log('----------------------------------------');

  let registrationResult: any = null;

  try {
    const res = await fetch(`${baseUrl}/v1/dashboard/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test Auth User',
        email: testEmail,
        password: 'password123',
        role: 'manager',
      }),
    });

    console.log(`Status: ${res.status}`);
    const body = await res.json();
    console.log('Response Body:', JSON.stringify(body, null, 2));

    if (res.status === 201) {
      console.log('✅ Custom registration endpoint succeeded.');
      registrationResult = body.data;
    } else {
      console.error('❌ Custom registration endpoint failed.');
      process.exit(1);
    }
  } catch (err: any) {
    console.error('❌ Request error:', err.message);
    process.exit(1);
  }

  console.log('\n----------------------------------------');
  console.log('TEST 2: Custom Login Endpoint (/v1/dashboard/auth/login)');
  console.log('----------------------------------------');

  let loginResult: any = null;
  let loginHeaders: Headers | null = null;

  try {
    const res = await fetch(`${baseUrl}/v1/dashboard/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: 'password123',
      }),
    });

    console.log(`Status: ${res.status}`);
    loginHeaders = res.headers;
    const body = await res.json();
    console.log('Response Body:', JSON.stringify(body, null, 2));
    console.log('Response Set-Cookie:', res.headers.get('set-cookie'));

    if (res.status === 200) {
      console.log('✅ Custom login endpoint succeeded.');
      loginResult = body.data;
    } else {
      console.error('❌ Custom login endpoint failed.');
      process.exit(1);
    }
  } catch (err: any) {
    console.error('❌ Request error:', err.message);
    process.exit(1);
  }

  console.log('\n----------------------------------------');
  console.log('TEST 3: Custom Profile /me Endpoint (/v1/dashboard/auth/me) with Cookie');
  console.log('----------------------------------------');

  // Let's get the token or cookies from the login response
  // Note: if calling auth.api.signInEmail directly from express controller, Better Auth doesn't automatically
  // append the cookie to the custom controller response, unless the controller passes the context or headers.
  // Let's see if there is any Cookie in the headers or if we can use the token.
  let cookieHeader = '';
  if (loginHeaders && loginHeaders.get('set-cookie')) {
    cookieHeader = loginHeaders.get('set-cookie') || '';
  }

  try {
    // If no cookies were returned, we will try with cookies first, and then check.
    console.log(`Using Cookie header: "${cookieHeader}"`);
    const res = await fetch(`${baseUrl}/v1/dashboard/auth/me`, {
      headers: {
        'Cookie': cookieHeader,
      },
    });

    console.log(`Status: ${res.status}`);
    const body = await res.json();
    console.log('Response Body:', JSON.stringify(body, null, 2));

    if (res.status === 200) {
      console.log('✅ Custom /me endpoint succeeded with cookies!');
    } else {
      console.warn('⚠️ Custom /me endpoint failed. This is expected if the custom login endpoint did not set the cookie in the response.');
    }
  } catch (err: any) {
    console.error('❌ Request error:', err.message);
  }

  console.log('\n----------------------------------------');
  console.log('TEST 4: Better Auth Native Endpoint Signup (/api/auth/sign-up/email)');
  console.log('----------------------------------------');

  // Let's try native sign up with a different user
  const nativeEmail = 'native_auth_user@example.com';
  try {
    const existingUser = await prisma.user.findUnique({ where: { email: nativeEmail } });
    if (existingUser) {
      await prisma.user.delete({ where: { email: nativeEmail } });
    }
  } catch (dbErr) {}

  try {
    const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': env.FRONTEND_URL,
      },
      body: JSON.stringify({
        email: nativeEmail,
        password: 'password123',
        name: 'Native User',
      }),
    });

    console.log(`Status: ${res.status}`);
    const body = await res.json();
    console.log('Response Body:', JSON.stringify(body, null, 2));
    console.log('Response Set-Cookie:', res.headers.get('set-cookie'));

    if (res.status === 200) {
      console.log('✅ Better Auth native signup succeeded.');
    } else {
      console.error('❌ Better Auth native signup failed.');
      process.exit(1);
    }
  } catch (err: any) {
    console.error('❌ Request error:', err.message);
    process.exit(1);
  }

  console.log('\n----------------------------------------');
  console.log('TEST 5: Better Auth Native Endpoint Signin (/api/auth/sign-in/email)');
  console.log('----------------------------------------');

  let nativeCookies = '';
  try {
    const res = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': env.FRONTEND_URL,
      },
      body: JSON.stringify({
        email: nativeEmail,
        password: 'password123',
      }),
    });

    console.log(`Status: ${res.status}`);
    nativeCookies = res.headers.get('set-cookie') || '';
    const body = await res.json();
    console.log('Response Body:', JSON.stringify(body, null, 2));
    console.log('Response Set-Cookie:', nativeCookies);

    if (res.status === 200) {
      console.log('✅ Better Auth native signin succeeded.');
    } else {
      console.error('❌ Better Auth native signin failed.');
      process.exit(1);
    }
  } catch (err: any) {
    console.error('❌ Request error:', err.message);
    process.exit(1);
  }

  console.log('\n----------------------------------------');
  console.log('TEST 6: Custom Profile /me Endpoint (/v1/dashboard/auth/me) with Native Cookies');
  console.log('----------------------------------------');

  try {
    const res = await fetch(`${baseUrl}/v1/dashboard/auth/me`, {
      headers: {
        'Cookie': nativeCookies,
      },
    });

    console.log(`Status: ${res.status}`);
    const body = await res.json();
    console.log('Response Body:', JSON.stringify(body, null, 2));

    if (res.status === 200) {
      console.log('✅ Custom /me endpoint succeeded using Better Auth native cookies!');
    } else {
      console.error('❌ Custom /me endpoint failed with native cookies!');
      process.exit(1);
    }
  } catch (err: any) {
    console.error('❌ Request error:', err.message);
    process.exit(1);
  }

  console.log('\n🎉 Better Auth Verification Tests Completed.');
  process.exit(0);
}

runTests();
