import { AuthProviderType } from '@worldbrain/memex-common/lib/authentication/types'
import {
    getAuth,
    signInWithPopup,
    GoogleAuthProvider,
    TwitterAuthProvider,
    AuthProvider,
    UserCredential,
} from 'firebase/auth'

export async function signInViaProvider(
    providerType: AuthProviderType,
): Promise<UserCredential> {
    const auth = getAuth()
    const provider = providerFromType(providerType)
    if (!provider) {
        throw new Error(`Unknown auth provider: ${providerType}`)
    }
    const credentials = await signInWithPopup(auth, provider)
    return credentials
}

function providerFromType(providerId: AuthProviderType): AuthProvider | null {
    if (providerId === 'google') {
        return new GoogleAuthProvider()
    }
    if (providerId === 'twitter') {
        return new TwitterAuthProvider()
    }
    return null
}
