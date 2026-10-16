import { provideHttpClient, withFetch, withInterceptors, withXsrfConfiguration } from '@angular/common/http';
import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { apiInterceptor } from './core/api/api.interceptor';
import { AuthService } from './core/auth/auth.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ scrollPositionRestoration: 'top' })),
    provideHttpClient(
      withFetch(),
      withInterceptors([apiInterceptor]),
      // The API binds a CSRF token to each session and expects it back in this header.
      withXsrfConfiguration({ cookieName: 'ss_csrf', headerName: 'X-CSRF-Token' }),
    ),
    // Load the current session before the first navigation so guards know who is signed in.
    provideAppInitializer(() => inject(AuthService).refresh().then(() => undefined)),
  ],
};
