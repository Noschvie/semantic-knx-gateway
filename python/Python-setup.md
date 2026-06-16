# Python Setup – KNX Bus Logger

## Virtual Environment and Connectivity Tests

This document describes how to set up a Python development environment for the KNX Bus Logger project,
install the required dependencies, and verify communication with a KNX/IP interface.

---

## Prerequisites

- Debian Trixie
- Python 3.13
- Network access to the KNX/IP interface
- KNXnet/IP tunnelling enabled on the interface

---

## 1. Create a Python Virtual Environment

Install the Python virtual environment package if it is not already available:

```bash
sudo apt update
sudo apt install python3.13-venv
```

Navigate to the project directory:

```bash
cd ~/KNX-Bus-Logger
```

Create a virtual environment:

```bash
python3 -m venv venv
```

---

## 2. Activate the Virtual Environment

Activate the newly created environment:

```bash
source venv/bin/activate
```

Your shell prompt should now display the virtual environment name:

```text
(venv) user@host:~/KNX-Bus-Logger$
```

---

## 3. Install the xknx Library

Upgrade `pip` and install the required KNX library:

```bash
pip install --upgrade pip
pip install xknx
```

Verify that the installation was successful:

```bash
pip show xknx
```

---

## 4. Verify Connectivity to the KNX/IP Interface

Run the connection test script:

```bash
python test-knx-connection.py
```

Expected output:

```text
Connected
```

A successful result confirms that communication with the KNX/IP interface (`192.168.7.15`) via KNXnet/IP tunneling is operational.

---

## 5. Send a KNX Switching Command

Execute the switching test script:

```bash
python test-knx-switch_on.py
```

Expected output:

```text
ON sent
```

This sends a switching telegram to the configured KNX group address (for example, `1/1/93`).

---

## 6. Deactivate the Virtual Environment

When your work session is complete, leave the virtual environment:

```bash
deactivate
```

The `(venv)` prefix will disappear from the shell prompt, indicating that the environment has been deactivated.

---

## 7. Reusing the Environment

For future sessions, return to the project directory:

```bash
cd ~/KNX-Bus-Logger
```

Activate the virtual environment:

```bash
source venv/bin/activate
```

You can then rerun the test scripts as needed:

```bash
python test-knx-connection.py
python test-knx-switch_on.py
```

---

## Summary

After completing these steps, you will have:

- A dedicated Python virtual environment for the project
- The `xknx` library installed and verified
- Confirmed connectivity to the KNX/IP interface
- Successfully transmitted a KNX switching telegram

The environment is now ready for KNX Bus Logger development and testing.
