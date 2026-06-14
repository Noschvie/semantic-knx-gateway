// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import asyncio

from xknx import XKNX
from xknx.devices import Switch
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

    # Define a KNX Switch device with its name and group address
    sw = Switch(
        xknx,
        "Steckdose Galerie",   # Descriptive name of the device
        group_address="1/1/114" # KNX group address to send the ON command to
    )

    # Send an ON telegram to the group address
    await sw.set_on()

    print("ON command sent")

    # Gracefully shut down the connection
    await xknx.stop()

asyncio.run(main())


