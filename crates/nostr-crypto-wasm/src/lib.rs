//! SHA-256 event-id check plus BIP-340 Schnorr verify for `@qntx/nostr/wasm`.
//!
//! Plain functions are no-panic: invalid lengths or points return `false`.
//! `#[wasm_bindgen]` wrappers are a thin ABI over those functions.

#![allow(
    unsafe_code,
    reason = "wasm-bindgen emits unsafe extern shims for exported functions"
)]

use secp256k1::schnorr::Signature;
use secp256k1::{SECP256K1, XOnlyPublicKey};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::wasm_bindgen;

/// BIP-340 verify of a 32-byte message (`id`), 32-byte x-only pubkey, and 64-byte signature.
///
/// Returns `false` when any input has the wrong length or is not a valid point/signature.
#[must_use]
pub fn verify_id_sig(id: &[u8], pubkey: &[u8], sig: &[u8]) -> bool {
    let Ok(id32): Result<&[u8; 32], _> = id.try_into() else {
        return false;
    };
    let Ok(pk_bytes): Result<&[u8; 32], _> = pubkey.try_into() else {
        return false;
    };
    let Ok(sig_bytes): Result<&[u8; 64], _> = sig.try_into() else {
        return false;
    };
    let Ok(pk) = XOnlyPublicKey::from_byte_array(*pk_bytes) else {
        return false;
    };
    let signature = Signature::from_byte_array(*sig_bytes);
    SECP256K1.verify_schnorr(&signature, id32, &pk).is_ok()
}

/// SHA-256(`serialized`) must equal `id`, then [`verify_id_sig`].
#[must_use]
pub fn verify_serialized_bytes(serialized: &[u8], id: &[u8], pubkey: &[u8], sig: &[u8]) -> bool {
    let Ok(id32): Result<&[u8; 32], _> = id.try_into() else {
        return false;
    };
    if Sha256::digest(serialized).as_slice() != id32.as_slice() {
        return false;
    }
    verify_id_sig(id, pubkey, sig)
}

/// Owned slices so the wasm allocator frees the JS-copied buffers after return.
#[must_use]
#[allow(
    clippy::needless_pass_by_value,
    reason = "owned Box drops the wasm-bindgen copy; a borrow would leak it"
)]
#[wasm_bindgen]
pub fn verify(id: Box<[u8]>, pubkey: Box<[u8]>, sig: Box<[u8]>) -> bool {
    verify_id_sig(&id, &pubkey, &sig)
}

/// Owned slices so the wasm allocator frees the JS-copied buffers after return.
#[must_use]
#[allow(
    clippy::needless_pass_by_value,
    reason = "owned Box drops the wasm-bindgen copy; a borrow would leak it"
)]
#[wasm_bindgen]
pub fn verify_serialized(
    serialized: Box<[u8]>,
    id: Box<[u8]>,
    pubkey: Box<[u8]>,
    sig: Box<[u8]>,
) -> bool {
    verify_serialized_bytes(&serialized, &id, &pubkey, &sig)
}

#[cfg(test)]
mod tests {
    use super::{verify_id_sig, verify_serialized_bytes};
    use secp256k1::{Keypair, SECP256K1, SecretKey};
    use sha2::{Digest, Sha256};

    fn sign_id(seckey: [u8; 32], id: [u8; 32]) -> ([u8; 32], [u8; 64]) {
        let secret = SecretKey::from_byte_array(seckey).expect("test secret key");
        let keypair = Keypair::from_secret_key(SECP256K1, &secret);
        let signature = keypair.sign_schnorr_no_aux_rand(&id);
        (
            keypair.x_only_public_key().0.serialize(),
            signature.to_byte_array(),
        )
    }

    #[test]
    fn rejects_wrong_lengths() {
        let id = [1_u8; 32];
        let pk = [2_u8; 32];
        let sig = [3_u8; 64];
        assert!(!verify_id_sig(&[], &pk, &sig), "empty id");
        assert!(
            !verify_id_sig(id.get(..31).expect("id prefix"), &pk, &sig),
            "31-byte id"
        );
        assert!(!verify_id_sig(&[1_u8; 33], &pk, &sig), "33-byte id");
        assert!(!verify_id_sig(&id, &[], &sig), "empty pubkey");
        assert!(
            !verify_id_sig(&id, pk.get(..31).expect("pk prefix"), &sig),
            "31-byte pubkey"
        );
        assert!(!verify_id_sig(&id, &[2_u8; 33], &sig), "33-byte pubkey");
        assert!(!verify_id_sig(&id, &pk, &[]), "empty sig");
        assert!(
            !verify_id_sig(&id, &pk, sig.get(..63).expect("sig prefix")),
            "63-byte sig"
        );
        assert!(!verify_id_sig(&id, &pk, &[3_u8; 65]), "65-byte sig");
    }

    #[test]
    fn serialized_rejects_hash_mismatch_and_bad_sig() {
        let serialized = b"hello";
        let digest = Sha256::digest(serialized);
        let mut wrong = digest;
        if let Some(first) = wrong.first_mut() {
            *first ^= 1;
        }
        let pk = [2_u8; 32];
        let sig = [3_u8; 64];
        assert!(
            !verify_serialized_bytes(serialized, wrong.as_slice(), &pk, &sig),
            "id must equal sha256(serialized)"
        );
        assert!(
            !verify_serialized_bytes(serialized, digest.as_slice(), &pk, &sig),
            "matching hash with garbage key/sig must fail schnorr"
        );
        assert!(
            !verify_serialized_bytes(serialized, &[], &pk, &sig),
            "empty id"
        );
    }

    #[test]
    fn serialized_accepts_matching_hash_and_valid_sig() {
        let serialized = b"[0,\"pk\",1,1,[],\"hello\"]";
        let id: [u8; 32] = Sha256::digest(serialized).into();
        let mut seckey = [0_u8; 32];
        *seckey.last_mut().expect("32-byte secret") = 3;
        let (pk, sig) = sign_id(seckey, id);
        assert!(
            verify_serialized_bytes(serialized, &id, &pk, &sig),
            "hash+schnorr must succeed for a crate-signed payload"
        );
        assert!(
            verify_id_sig(&id, &pk, &sig),
            "id-only verify must succeed for the same signature"
        );
        let mut tampered = serialized.to_vec();
        if let Some(byte) = tampered.get_mut(1) {
            *byte = b'X';
        }
        assert!(
            !verify_serialized_bytes(&tampered, &id, &pk, &sig),
            "tampered serialization must fail the hash check"
        );
    }
}
