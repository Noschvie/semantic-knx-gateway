# KNX IP Secure Integration Specification

## 1. Purpose

This document specifies the design and implementation of optional **KNX
IP Secure** support for the KNX Runtime Engine. The objective is to
extend the existing `TunnelManager` without affecting the application
logic or existing KNX/IP functionality.

The implementation shall support both classic KNX/IP and KNX IP Secure
using the same code base.

------------------------------------------------------------------------

## 2. Background

The current implementation communicates with a KNX installation using
**KNXUltimate** over standard KNXnet/IP tunneling (UDP).

KNX IP Secure protects the communication channel between the application
and the KNX IP Interface by providing authentication, integrity
protection and encryption. The implementation relies on the secure
capabilities already provided by the KNXUltimate library.

No cryptographic functionality shall be implemented within this project.

------------------------------------------------------------------------

## 3. Objectives

The implementation shall:

-   support both Classic KNX/IP and KNX IP Secure
-   keep the existing TunnelManager architecture
-   require no modifications to the StateEngine
-   require no modifications to the TelegramDecoder
-   require no modifications to the TelegramQueue
-   allow switching between Classic and Secure by configuration only
-   remain fully backward compatible

------------------------------------------------------------------------

## 4. Architecture

    StateEngine
          │
    TelegramDecoder
          │
    TunnelManager
          │
    createTunnelOptions()
          │
    KNXUltimate
          │
     ┌───────────────┐
     │ Tunnel UDP    │
     │ Tunnel TCP    │
     │ KNX IP Secure │
     └───────────────┘
          │
    Weinzierl 732 Secure
          │
    KNX TP

Only the connection layer is extended. All upper software layers remain
unchanged.

------------------------------------------------------------------------

## 5. Configuration

The implementation shall be controlled using environment variables.

  Variable               Description
  ---------------------- ---------------------------------
  KNX_SECURE             Enable or disable KNX IP Secure
  KNX_HOST_PROTOCOL      TunnelUDP or TunnelTCP
  KNX_KEYRING_FILE       ETS Keyring (.knxkeys)
  KNX_KEYRING_PASSWORD   Password protecting the Keyring

When `KNX_SECURE=false`, the application behaves exactly like the
current implementation.

------------------------------------------------------------------------

## 6. Implementation Strategy

A dedicated module (`tunnel-options.js`) shall be introduced.

Responsibilities:

-   create KNXUltimate configuration
-   evaluate environment variables
-   enable Secure when configured
-   configure `secureTunnelConfig`
-   return a fully initialized options object

The TunnelManager shall only request the configuration object and create
the KNX client.

------------------------------------------------------------------------

## 7. TunnelManager Changes

Only the connection initialization shall be modified.

No changes are required for:

-   reconnect handling
-   health monitoring
-   telegram decoding
-   telegram queue
-   telegram processing
-   write operations
-   indication processing

The existing runtime behaviour shall remain unchanged.

------------------------------------------------------------------------

## 8. KNXUltimate Integration

When Secure mode is enabled the following options shall be configured:

-   `isSecureKNXEnabled`
-   `secureTunnelConfig`
-   `TunnelTCP`

The ETS Keyring shall be used as the preferred authentication mechanism.

The implementation shall not duplicate cryptographic functionality
already provided by KNXUltimate.

------------------------------------------------------------------------

## 9. ETS Requirements

The KNX installation shall provide:

-   Weinzierl 732 Secure
-   KNX IP Secure enabled
-   exported ETS Keyring
-   Keyring password

No additional project changes are required.

------------------------------------------------------------------------

## 10. Logging

The connection log shall indicate:

-   Classic or Secure mode
-   protocol (UDP/TCP)
-   gateway address
-   successful secure session establishment
-   reconnect attempts
-   connection failures

Logging shall allow diagnosis without enabling KNXUltimate debug output.

------------------------------------------------------------------------

## 11. Testing

The following scenarios shall be verified:

### Classic Mode

-   connect
-   reconnect
-   read
-   write
-   indication reception

### Secure Mode

-   secure session establishment
-   reconnect
-   read
-   write
-   indication reception
-   restart of Weinzierl interface
-   invalid Keyring
-   invalid password

------------------------------------------------------------------------

## 12. Future Enhancements

Possible future improvements include:

-   automatic Secure capability detection
-   automatic fallback between Secure and Classic
-   Secure Routing support
-   advanced connection diagnostics
-   runtime capability reporting

------------------------------------------------------------------------

## 13. Summary

This design introduces KNX IP Secure with minimal impact on the existing
architecture.

The implementation is intentionally limited to the transport layer and
fully reuses the Secure functionality provided by KNXUltimate.

This approach minimizes maintenance effort while maintaining full
compatibility with existing KNX installations.
