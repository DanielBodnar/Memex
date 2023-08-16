import type {
    AuthService,
    LoginHooks,
} from '@worldbrain/memex-common/lib/authentication/types'
import { TEST_USER } from '@worldbrain/memex-common/lib/authentication/dev'
import { MemoryAuthService } from '@worldbrain/memex-common/lib/authentication/memory'
import { WorldbrainAuthService } from '@worldbrain/memex-common/lib/authentication/worldbrain'
import { SubscriptionsService } from '@worldbrain/memex-common/lib/subscriptions/types'
import { MemorySubscriptionsService } from '@worldbrain/memex-common/lib/subscriptions/memory'
import { WorldbrainSubscriptionsService } from '@worldbrain/memex-common/lib/subscriptions/worldbrain'
import { getFirebase } from 'src/util/firebase-app-initialized'
import {
    getAuth,
    createUserWithEmailAndPassword,
    signInWithCustomToken,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
} from 'firebase/auth'
import { signInViaProvider } from 'src/authentication/background/sign-in-via-provider'
import { getFunctions, httpsCallable } from 'firebase/functions'

export type DevAuthState =
    | ''
    | 'staging'
    | 'user_signed_out'
    | 'user_signed_in'
    | 'user_subscribed'
    | 'user_subscription_expired'
    | 'user_subscription_expires_60s'

export function createAuthDependencies(options: {
    devAuthState?: DevAuthState
    redirectUrl: string
    loginHooks?: LoginHooks
}): {
    authService: AuthService
    subscriptionService: SubscriptionsService
} {
    const devAuthState = (options && options.devAuthState) || ''
    if (devAuthState === '' || devAuthState === 'staging') {
        return {
            authService: new WorldbrainAuthService({
                ...(options.loginHooks ?? {}),
                firebase: {
                    getAuth,
                    getFunctions,
                    httpsCallable,
                    signInViaProvider,
                    signInWithCustomToken,
                    sendPasswordResetEmail,
                    signInWithEmailAndPassword,
                    createUserWithEmailAndPassword,
                },
            }),
            subscriptionService: new WorldbrainSubscriptionsService(
                getFirebase(),
                options.redirectUrl,
            ),
        }
    }

    if (devAuthState === 'user_signed_out') {
        return {
            authService: new MemoryAuthService(),
            subscriptionService: new MemorySubscriptionsService(),
        }
    }

    if (devAuthState === 'user_signed_in') {
        const authService = new MemoryAuthService()
        authService.setUser(TEST_USER)
        return {
            authService,
            subscriptionService: new MemorySubscriptionsService(),
        }
    }

    if (devAuthState === 'user_subscribed') {
        // todo: (ch): allow testing of different plans
        const authService = new MemoryAuthService()
        authService.setUser(TEST_USER)
        return {
            authService,
            subscriptionService: new MemorySubscriptionsService({
                expiry: Date.now() / 1000 + 1000 * 60 * 60 * 24,
            }),
        }
    }

    if (devAuthState === 'user_subscription_expired') {
        // todo: (ch): allow testing of different plans
        const authService = new MemoryAuthService()
        authService.setUser(TEST_USER)
        return {
            authService,
            subscriptionService: new MemorySubscriptionsService({
                expiry: Date.now() / 1000 - 1000 * 60 * 60,
            }),
        }
    }

    if (devAuthState === 'user_subscription_expires_60s') {
        const expiry = Date.now() / 1000 + 1000 * 60
        console['log'](
            `Using dev auth state: ${devAuthState}, expiring at ${new Date(
                expiry,
            ).toLocaleString()}`,
        )
        const authService = new MemoryAuthService()
        authService.setUser(TEST_USER)
        return {
            authService,
            subscriptionService: new MemorySubscriptionsService({
                expiry,
            }),
        }
    }

    throw new Error(
        `Tried to set up auth dependencies with unknown DEV_AUTH_STATE: ${devAuthState}`,
    )
}
