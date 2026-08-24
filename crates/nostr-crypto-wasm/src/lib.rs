//! SHA-256 event-id check plus BIP-340 Schnorr verify and sign for `@qntx/nostr/wasm`.
//!
//! Plain functions are no-panic: invalid lengths or points return `false` / [`None`].
//! `#[wasm_bindgen]` wrappers are a thin ABI over those functions.

#![allow(
    unsafe_code,
    reason = "wasm-bindgen emits unsafe extern shims for exported functions"
)]

use secp256k1::schnorr::Signature;
use secp256k1::{Keypair, SECP256K1, XOnlyPublicKey};
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

fn take_keypair(seckey: &mut [u8]) -> Option<Keypair> {
    let sk_bytes = <[u8; 32]>::try_from(&*seckey);
    seckey.fill(0);
    let mut sk_bytes = sk_bytes.ok()?;
    let keypair = Keypair::from_seckey_byte_array(SECP256K1, sk_bytes);
    sk_bytes.fill(0);
    keypair.ok()
}

/// BIP-340 sign of a 32-byte message. `aux` must be 32 bytes of caller entropy.
///
/// Wipes `seckey` before returning. Returns [`None`] on wrong lengths or an invalid scalar.
#[must_use]
pub fn sign_id(id: &[u8], seckey: &mut [u8], aux: &[u8]) -> Option<[u8; 64]> {
    let Ok(id32) = <[u8; 32]>::try_from(id) else {
        seckey.fill(0);
        return None;
    };
    let Ok(aux32) = <[u8; 32]>::try_from(aux) else {
        seckey.fill(0);
        return None;
    };
    let mut keypair = take_keypair(seckey)?;
    let sig = SECP256K1.sign_schnorr_with_aux_rand(&id32, &keypair, &aux32);
    keypair.non_secure_erase();
    Some(sig.to_byte_array())
}

/// x-only public key for a 32-byte secret key.
///
/// Wipes `seckey` before returning. Returns [`None`] on wrong length or an invalid scalar.
#[must_use]
pub fn public_key_bytes(seckey: &mut [u8]) -> Option<[u8; 32]> {
    let mut keypair = take_keypair(seckey)?;
    let (pk, _) = keypair.x_only_public_key();
    keypair.non_secure_erase();
    Some(pk.serialize())
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

/// Owned slices so the wasm allocator frees the JS-copied buffers after return.
/// Empty box maps [`None`] without trapping.
#[must_use]
#[allow(
    clippy::needless_pass_by_value,
    reason = "owned Box drops the wasm-bindgen copy; a borrow would leak it"
)]
#[wasm_bindgen]
pub fn sign(id: Box<[u8]>, mut seckey: Box<[u8]>, aux: Box<[u8]>) -> Box<[u8]> {
    sign_id(&id, &mut seckey, &aux)
        .map(Box::<[u8]>::from)
        .unwrap_or_default()
}

/// Owned slices so the wasm allocator frees the JS-copied buffers after return.
/// Empty box maps [`None`] without trapping.
#[must_use]
#[allow(
    clippy::needless_pass_by_value,
    reason = "owned Box drops the wasm-bindgen copy; a borrow would leak it"
)]
#[wasm_bindgen]
pub fn public_key(mut seckey: Box<[u8]>) -> Box<[u8]> {
    public_key_bytes(&mut seckey)
        .map(Box::<[u8]>::from)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        public_key, public_key_bytes, sign, sign_id, verify_id_sig, verify_serialized_bytes,
    };
    use secp256k1::{Keypair, SECP256K1, SecretKey};
    use sha2::{Digest, Sha256};

    fn sign_id_no_aux(seckey: [u8; 32], id: [u8; 32]) -> ([u8; 32], [u8; 64]) {
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
        let (pk, sig) = sign_id_no_aux(seckey, id);
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

    /// BIP-340 vector 0.
    const V0_SK: [u8; 32] = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 3,
    ];
    const V0_PK: [u8; 32] = [
        0xF9, 0x30, 0x8A, 0x01, 0x92, 0x58, 0xC3, 0x10, 0x49, 0x34, 0x4F, 0x85, 0xF8, 0x9D, 0x52,
        0x29, 0xB5, 0x31, 0xC8, 0x45, 0x83, 0x6F, 0x99, 0xB0, 0x86, 0x01, 0xF1, 0x13, 0xBC, 0xE0,
        0x36, 0xF9,
    ];
    const V0_AUX: [u8; 32] = [0; 32];
    const V0_MSG: [u8; 32] = [0; 32];
    const V0_SIG: [u8; 64] = [
        0xE9, 0x07, 0x83, 0x1F, 0x80, 0x84, 0x8D, 0x10, 0x69, 0xA5, 0x37, 0x1B, 0x40, 0x24, 0x10,
        0x36, 0x4B, 0xDF, 0x1C, 0x5F, 0x83, 0x07, 0xB0, 0x08, 0x4C, 0x55, 0xF1, 0xCE, 0x2D, 0xCA,
        0x82, 0x15, 0x25, 0xF6, 0x6A, 0x4A, 0x85, 0xEA, 0x8B, 0x71, 0xE4, 0x82, 0xA7, 0x4F, 0x38,
        0x2D, 0x2C, 0xE5, 0xEB, 0xEE, 0xE8, 0xFD, 0xB2, 0x17, 0x2F, 0x47, 0x7D, 0xF4, 0x90, 0x0D,
        0x31, 0x05, 0x36, 0xC0,
    ];

    #[test]
    fn public_key_matches_bip340_vector_0() {
        let mut seckey = V0_SK;
        let pk = public_key_bytes(&mut seckey).expect("valid secret");
        assert_eq!(pk, V0_PK, "x-only pubkey");
        assert_eq!(seckey, [0_u8; 32], "caller seckey buffer wiped");
    }

    #[test]
    fn sign_matches_bip340_vector_0() {
        let mut seckey = V0_SK;
        let sig = sign_id(&V0_MSG, &mut seckey, &V0_AUX).expect("valid sign");
        assert_eq!(sig, V0_SIG, "aux-rand signature");
        assert_eq!(seckey, [0_u8; 32], "caller seckey buffer wiped");
        assert!(
            verify_id_sig(&V0_MSG, &V0_PK, &sig),
            "crate-signed vector 0 must verify"
        );
    }

    #[test]
    fn sign_and_public_key_reject_wrong_lengths_and_invalid_scalar() {
        let mut empty = [];
        let mut short = [3_u8; 31];
        let mut long = [3_u8; 33];
        let mut zero = [0_u8; 32];
        assert!(
            sign_id(&V0_MSG, &mut empty, &V0_AUX).is_none(),
            "empty seckey"
        );
        assert!(
            sign_id(&V0_MSG, &mut short, &V0_AUX).is_none(),
            "31-byte seckey"
        );
        assert!(
            sign_id(&V0_MSG, &mut long, &V0_AUX).is_none(),
            "33-byte seckey"
        );
        let mut sk_bad_id = V0_SK;
        assert!(sign_id(&[], &mut sk_bad_id, &V0_AUX).is_none(), "empty id");
        assert_eq!(sk_bad_id, [0_u8; 32], "wiped after id length failure");
        let mut sk_bad_aux = V0_SK;
        assert!(
            sign_id(&V0_MSG, &mut sk_bad_aux, &[]).is_none(),
            "empty aux"
        );
        assert_eq!(sk_bad_aux, [0_u8; 32], "wiped after aux length failure");
        assert!(
            sign_id(&V0_MSG, &mut zero, &V0_AUX).is_none(),
            "zero scalar is not a secret key"
        );
        assert_eq!(zero, [0_u8; 32], "invalid scalar still wiped");
        assert!(public_key_bytes(&mut empty).is_none(), "empty seckey");
        assert!(public_key_bytes(&mut short).is_none(), "31-byte seckey");
        assert!(public_key_bytes(&mut long).is_none(), "33-byte seckey");
        let mut zero_pk = [0_u8; 32];
        assert!(
            public_key_bytes(&mut zero_pk).is_none(),
            "zero scalar is not a secret key"
        );
    }

    #[test]
    fn wasm_wrappers_return_empty_box_on_failure() {
        assert!(
            sign(Box::from(V0_MSG), Box::from([0_u8; 31]), Box::from(V0_AUX)).is_empty(),
            "31-byte seckey"
        );
        assert!(
            sign(Box::from([0_u8; 31]), Box::from(V0_SK), Box::from(V0_AUX)).is_empty(),
            "31-byte id"
        );
        assert!(
            sign(Box::from(V0_MSG), Box::from(V0_SK), Box::from([0_u8; 31])).is_empty(),
            "31-byte aux"
        );
        assert!(
            sign(Box::from(V0_MSG), Box::from([0_u8; 32]), Box::from(V0_AUX)).is_empty(),
            "zero scalar"
        );
        assert!(
            public_key(Box::from([0_u8; 31])).is_empty(),
            "31-byte seckey"
        );
        assert!(public_key(Box::from([0_u8; 32])).is_empty(), "zero scalar");
    }

    #[test]
    fn wasm_wrappers_return_vector_0() {
        let pk = public_key(Box::from(V0_SK));
        assert_eq!(pk.as_ref(), V0_PK.as_slice(), "wasm public_key");
        let sig = sign(Box::from(V0_MSG), Box::from(V0_SK), Box::from(V0_AUX));
        assert_eq!(sig.as_ref(), V0_SIG.as_slice(), "wasm sign");
    }
}
