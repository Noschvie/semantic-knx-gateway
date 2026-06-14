// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import asyncio

from xknx import XKNX
from xknx.io import ConnectionConfig, ConnectionType

def telegram_received(telegram):
    # Callback function: called whenever a KNX telegram is received on the bus
    print(telegram)

async def main():
    # Create an XKNX instance with tunneling connection to the KNX/IP gateway
    xknx = XKNX(
        connection_config=ConnectionConfig(
            connection_type=ConnectionType.TUNNELING,  # Use KNX IP Tunneling protocol
            gateway_ip="192.168.7.18",                 # IP address of the KNX/IP gateway
        )
    )

    # Register the callback so it is invoked for every incoming telegram
    xknx.telegram_queue.register_telegram_received_cb(telegram_received)

    # Establish the connection to the KNX gateway
    await xknx.start()

    print("Logger running - press Ctrl+C to stop")

    # Run indefinitely, printing all telegrams as they arrive
    while True:
        await asyncio.sleep(1)

asyncio.run(main())


