//! Vendored BIP-340 vectors against the plain (non-wasm) verify functions.

#![allow(
    unused_crate_dependencies,
    reason = "integration tests do not import the lib crate's dependencies"
)]
#![allow(
    clippy::expect_used,
    reason = "vendored CSV parser fails the test on a malformed fixture"
)]
#![allow(
    clippy::tests_outside_test_module,
    reason = "integration test crate is itself the test module"
)]

use nostr_crypto_wasm::verify_id_sig;

const VECTORS: &str = include_str!("bip-0340-test-vectors.csv");

const fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode_hex(input: &str) -> Vec<u8> {
    let bytes = input.as_bytes();
    assert!(
        bytes.len().is_multiple_of(2),
        "hex length must be even, got {} for {input}",
        bytes.len()
    );
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let [hi, lo] = pair else {
            unreachable!("chunks_exact(2)");
        };
        let hi = hex_nibble(*hi).expect("hex digit");
        let lo = hex_nibble(*lo).expect("hex digit");
        out.push((hi << 4) | lo);
    }
    out
}

struct Vector<'a> {
    index: &'a str,
    pubkey: Vec<u8>,
    message: Vec<u8>,
    signature: Vec<u8>,
    expected: bool,
    comment: &'a str,
}

fn parse_vectors(csv: &str) -> Vec<Vector<'_>> {
    let mut rows = csv.lines();
    let header = rows.next().expect("csv header");
    assert!(
        header.starts_with("index,secret key,public key,"),
        "unexpected BIP-340 csv header: {header}"
    );
    rows.filter(|line| !line.is_empty())
        .map(parse_row)
        .collect()
}

fn parse_row(line: &str) -> Vector<'_> {
    let mut fields = line.splitn(8, ',');
    let index = fields.next().expect("index");
    let _ = fields.next().expect("secret key");
    let pubkey = decode_hex(fields.next().expect("public key"));
    let _ = fields.next().expect("aux_rand");
    let message = decode_hex(fields.next().expect("message"));
    let signature = decode_hex(fields.next().expect("signature"));
    let result = fields.next().expect("verification result");
    let comment = fields.next().unwrap_or("");
    assert!(
        result == "TRUE" || result == "FALSE",
        "vector {index}: unknown result {result}"
    );
    let expected = result == "TRUE";
    Vector {
        index,
        pubkey,
        message,
        signature,
        expected,
        comment,
    }
}

#[test]
fn bip340_csv_matches_verify_id_sig() {
    let rows = parse_vectors(VECTORS);
    assert!(
        rows.len() >= 15,
        "expected the full BIP-340 csv, got {} data rows",
        rows.len()
    );
    for row in rows {
        if row.message.len() != 32 {
            assert!(
                !verify_id_sig(&row.message, &row.pubkey, &row.signature),
                "vector {}: non-32-byte message must be rejected by the event-id API ({})",
                row.index,
                row.comment
            );
            continue;
        }
        let got = verify_id_sig(&row.message, &row.pubkey, &row.signature);
        assert_eq!(
            got, row.expected,
            "vector {}: {} (comment: {})",
            row.index, row.comment, row.comment
        );
    }
}
