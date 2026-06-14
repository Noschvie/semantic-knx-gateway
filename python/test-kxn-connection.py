// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import asyncio

from xknx import XKNX
from xknx.io import ConnectionConfig, ConnectionType

async def main():
    # Create an XKNX instance with tunneling connection to the KNX/IP gateway
    xknx = XKNX(
        connection_config=ConnectionConfig(
            connection_type=ConnectionType.TUNNELING,  # Use KNX IP Tunneling protocol
            gateway_ip="192.168.7.18",                 # IP address of the KNX/IP gateway
        )
    )

    # Establish the connection to the KNX gateway
    await xknx.start()

    print("Connected")

    # Keep the connection alive for 10 seconds, then disconnect
    await asyncio.sleep(10)

    # Gracefully shut down the connection
    await xknx.stop()

asyncio.run(main())

