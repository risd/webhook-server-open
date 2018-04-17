# Managing WebHook Server Processes

The backbone of `risd.systems` is the WebHook Server. This server is a Google Cloud Compute Instance, and is responsible for running the [WebHook Server Application][webhook-server].

There are a number of processes that are defined within the WebHook Server Application that enable the WebHook system to function. These processes are managed by [Supervisor][supervisor], an application created to easily start, stop, and view the status of a process. The [Supervisor configuration][webhook-conf] file is used to define these processes.

- [Using Supervisor](#using-supervisor)
- [Restarting WebHook Processes](#restarting-webhook-processes)


### Using Supervisor

[Supervisor][supervisor] is a command line interface that is available on `webhook-1`. Using the Google Cloud Compute Dashboard, an SSH connection can be made from within the browser.

To connect to `webhook-1` via SSH, visit the [list of Google Compute Instances][compute-instances] and press the `SSH` button under the `Connect` column of the table, for the row that represents `webhook-1`. This will launch a new browser window with a command line prompt that reads `risdweb@webhook-1:~$`. From here, the following Supervisor commands can be used.


###### `status`

`sudo supervisorctl status` is used to view the status of all current processes. This will output a list of all processes that are being managed by [Supervisor][supervisor], and some information about each process.

```
risdweb@webhook-1:~$ sudo supervisorctl status
beanstalk                        RUNNING    pid 5840, uptime 18:32:30
build_worker:build_worker_00     RUNNING    pid 5790, uptime 18:32:30
build_worker:build_worker_01     RUNNING    pid 5784, uptime 18:32:30
build_worker:build_worker_02     RUNNING    pid 5778, uptime 18:32:30
build_worker:build_worker_03     RUNNING    pid 5808, uptime 18:32:30
command_delegator                RUNNING    pid 5791, uptime 18:32:30
create_worker                    RUNNING    pid 5838, uptime 18:32:30
invite_worker                    RUNNING    pid 5797, uptime 18:32:30
reaper                           RUNNING    pid 13880, uptime 7 days, 17:09:09
webhook_server                   RUNNING    pid 5137, uptime 19:36:00
```

The first column of output is the process name, which maps to the names defined in the [Supervisor configuration][webhook-conf]. The second column will show the current status. The expected status for all processes is `RUNNING`. The third column is the process ID, and the fourth column displays how long the process has been running.


###### `tail`

`sudo supervisorctl tail <process-name>` is used to display the latest output of the `process-name` passed in. These names are the same as the first column of output that resulted from running the `status` command. To view the output of the `webhook_server` process, the command would be `sudo supervisorctl tail webhook_server`.

To see the continuous output of a process, use the `-f` flag. This is useful when checking in on how messages are being passed through a process as its happening. For the `webhook_server` example, the command is `sudo supervisorctl tail -f webhook_server`. Using this command will start a subprocess for viewing the logs in real time. To exit this view and return the prompt press `ctrl+c`.


###### `stop`

`sudo supervisorctl stop <process-name>` is used to stop a process by name. Valid process names include all of the ones defined in the `status` command, as well as `all`, which will stop all processes; `sudo supervisorctl stop all`. Or wildcards to match a series of processes. For example, stopping all build workers, `sudo supervisorctl stop build_worker:*`.

Stopping a process, and then running the `status` command will change the status value to `STOPPED`.


###### `start`

`sudo supervisorctl start <process-name>` is used to start a process by name. Valid process names include all of the ones defined in the `status` command, as well as `all`, which will start all processes; `sudo supervisorctl start all`. Or wildcards to match a series of processes. For example, starting all build workers, `sudo supervisorctl start build_worker:*`.

Starting a process, and then running the `status` command will change the status value from to `RUNNING`.


###### `restart`

`sudo supervisorctl restart <process-name>` is used to restart a process by name. Restarting is equivalent to running `stop` & `start` on a process. Valid process names include all of the ones defined in the `status` command, as well as `all`, which will restart all processes; `sudo supervisorctl restart all`. Or wildcards to match a series of processes. For example, restarting all build workers, `sudo supervisorctl restart build_worker:*`.

Restarting a process, and then running the `status` command will change the status value from to `RUNNING`.



### Restarting WebHook Processes

If WebHook gets itself into a bind, it can be helpful to restart the processes. The steps follow.

- Stop all running processes
- Ensure the `webhook_server` & `beanstalkd` are no longer bound to their ports (3000 & 11300)
- Start all processes
- Ensure status


###### Stop all running processes.

```sudo supervisorctl stop all```


###### Ensure the `webhook_server` & `beanstalkd` are no longer bound to their ports (3000 & 11300)

To ensure that the `webhook_server` is still not bound to its port (3000), use the `netstat` command, and filter the output to only show processes bound to port 3000; `sudo netstat -nlp | grep 3000`. This will return no output if there is no `webhook_server` still on port 3000.

```
risdweb@webhook-1:~$ sudo netstat -nlp | grep 3000
risdweb@webhook-1:~$
```

If there is output, it will look like the following line, but with a different process ID.

```
risdweb@webhook-1:~$ sudo netstat -nlp | grep 3000
tcp6       0      0 :::3000                 :::*                    LISTEN      5148/grunt
```

The third column of output includes the port that the `grep` command has matched and filtered for. The last column shows the process ID and the command used to start the process seperated by a `/`. The process ID can be used to manually kill the process. Run the `kill` command and pass in the process ID. `sudo kill 5148`. Subsequently running `sudo netstat -nlp | grep 3000` should return no output.

```
risdweb@webhook-1:~$ sudo kill 5148
risdweb@webhook-1:~$ sudo netstat -nlp | grep 3000
risdweb@webhook-1:~$
```

The same can be done for `beanstalkd`, but instead looking for the process ID on port `11300`. Running `sudo netstat -nlp | grep 11300` will either give no output, or a line that looks like the following, but with a different process ID.

```
risdweb@webhook-1:~$ sudo netstat -nlp | grep 11300
tcp        0      0 0.0.0.0:11300           0.0.0.0:*               LISTEN      5840/beanstalkd
```

To kill the running `beanstalkd` process, `sudo kill 5840`.

```
risdweb@webhook-1:~$ sudo kill 5840
risdweb@webhook-1:~$ sudo netstat -nlp | grep 11300
risdweb@webhook-1:~$
```


###### Start all processes

With all processes stopped unbound from their ports, it is safe to start all processes.

```sudo supervisorctl start all```


##### Ensure status

Run the `status` command to ensure that all processes are running.

```
risdweb@webhook-1:~$ sudo supervisorctl status
beanstalk                        RUNNING    pid 5840, uptime 00:00:05
build_worker:build_worker_00     RUNNING    pid 5790, uptime 00:00:05
build_worker:build_worker_01     RUNNING    pid 5784, uptime 00:00:05
build_worker:build_worker_02     RUNNING    pid 5778, uptime 00:00:05
build_worker:build_worker_03     RUNNING    pid 5808, uptime 00:00:05
command_delegator                RUNNING    pid 5791, uptime 00:00:05
create_worker                    RUNNING    pid 5838, uptime 00:00:05
invite_worker                    RUNNING    pid 5797, uptime 00:00:05
reaper                           RUNNING    pid 13880, uptime 00:00:05
webhook_server                   RUNNING    pid 5137, uptime 00:00:05
```

If one is not running, use the `tail` command to inspect its output and further diagnose the problem.


[webhook-server]:https://github.com/risd/webhook-server-open
[webhook-conf]:https://github.com/risd/webhook-server-open/blob/master/webhook.conf
[compute-instances]:https://console.cloud.google.com/compute/instances?project=risd-media-webhook
[supervisor]:http://supervisord.org/introduction.html
